output "url" {
  description = "Base URL of the search service (HTTP only)."
  value       = "http://${aws_lb.main.dns_name}"
}

output "run_ingest" {
  description = "Run this once to load SciFact into the database; follow it in the /ecs/rag-search log group."
  value = join(" ", [
    "aws ecs run-task --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --launch-type FARGATE",
    "--task-definition ${aws_ecs_task_definition.ingest.family}",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", data.aws_subnets.default.ids)}],securityGroups=[${aws_security_group.service.id}],assignPublicIp=ENABLED}'",
  ])
}

output "dashboard" {
  description = "CloudWatch dashboard with latency, errors, load balancer and database."
  value       = "https://${var.region}.console.aws.amazon.com/cloudwatch/home?region=${var.region}#dashboards/dashboard/${aws_cloudwatch_dashboard.main.dashboard_name}"
}
