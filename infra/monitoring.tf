resource "aws_sns_topic" "alarms" {
  name = "rag-search-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# The RagSearch metrics are not sent by any agent: the service logs one JSON line per request in
# CloudWatch's embedded metric format (see metricLine in src/server.ts) and CloudWatch Logs turns
# the line into LatencyMs, Errors and Results.
resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "rag-search-latency-p95"
  alarm_description   = "p95 of the search latency is over 500 ms in 3 of the last 5 minutes."
  namespace           = "RagSearch"
  metric_name         = "LatencyMs"
  dimensions          = { Route = "search" }
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 500
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "rag-search-errors"
  alarm_description   = "Five or more searches failed in five minutes (database or model trouble)."
  namespace           = "RagSearch"
  metric_name         = "Errors"
  dimensions          = { Route = "search" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "rag-search-alb-5xx"
  alarm_description   = "The tasks returned five or more 5xx responses in five minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "rag-search-unhealthy-hosts"
  alarm_description   = "A task failed its health check for three minutes in a row."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.service.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "rag-search-db-cpu"
  alarm_description   = "The database CPU is over 80% for 10 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "rag-search"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Search latency (ms)"
          region = var.region
          period = 60
          metrics = [
            ["RagSearch", "LatencyMs", "Route", "search", { stat = "p50", label = "p50" }],
            ["RagSearch", "LatencyMs", "Route", "search", { stat = "p95", label = "p95" }],
            ["RagSearch", "LatencyMs", "Route", "search", { stat = "p99", label = "p99" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Searches and failures"
          region = var.region
          period = 60
          stat   = "Sum"
          metrics = [
            ["RagSearch", "Results", "Route", "search", { stat = "SampleCount", label = "searches" }],
            ["RagSearch", "Errors", "Route", "search", { label = "failed" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, { label = "5xx at the balancer" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Tasks that pass the health check"
          region = var.region
          period = 60
          stat   = "Minimum"
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.service.arn_suffix],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Database"
          region = var.region
          period = 60
          stat   = "Average"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier, { yAxis = "right" }],
          ]
        }
      },
      {
        type   = "log"
        x      = 0
        y      = 12
        width  = 24
        height = 6
        properties = {
          title  = "Latest failed searches"
          region = var.region
          view   = "table"
          query  = "SOURCE '${aws_cloudwatch_log_group.service.name}' | fields @timestamp, RequestId, Error | filter Errors = 1 | sort @timestamp desc | limit 20"
        }
      },
    ]
  })
}
