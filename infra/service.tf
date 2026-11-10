locals {
  secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn

  environment = [
    { name = "PGHOST", value = aws_db_instance.main.address },
    { name = "PGPORT", value = "5432" },
    { name = "PGDATABASE", value = "rag" },
    { name = "PGUSER", value = "rag" },
  ]

  # RDS keeps {"username": ..., "password": ...} in the secret; ECS can take one key of it.
  secrets = [
    { name = "PGPASSWORD", valueFrom = "${local.secret_arn}:password::" },
  ]
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/rag-search"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The execution role is what ECS itself uses to start a task: pull the image, write the logs and
# read the one secret. The containers get no role of their own, because they call no AWS API.
resource "aws_iam_role" "execution" {
  name               = "rag-search-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_db_secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.secret_arn]
  }
}

resource "aws_iam_role_policy" "read_db_secret" {
  name   = "read-db-secret"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_db_secret.json
}

resource "aws_ecs_cluster" "main" {
  name = "rag-search"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "service" {
  family                   = "rag-search"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name         = "service"
      image        = var.image
      essential    = true
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      environment  = local.environment
      secrets      = local.secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "service"
        }
      }
    }
  ])
}

# Run once by hand (see the `run_ingest` output): downloads SciFact, embeds it on the CPU and
# fills the database. It is a task definition, not a service, so it costs nothing while idle.
resource "aws_ecs_task_definition" "ingest" {
  family                   = "rag-ingest"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 2048
  memory                   = 4096
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name        = "ingest"
      image       = var.image
      essential   = true
      command     = ["node", "src/ingest.ts"]
      environment = local.environment
      secrets     = local.secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ingest"
        }
      }
    }
  ])
}

resource "aws_lb" "main" {
  name                       = "rag-search"
  load_balancer_type         = "application"
  internal                   = false
  security_groups            = [aws_security_group.alb.id]
  subnets                    = data.aws_subnets.default.ids
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "service" {
  name        = "rag-search"
  port        = 3000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  deregistration_delay = 15

  health_check {
    path                = "/healthz"
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.service.arn
  }
}

resource "aws_ecs_service" "service" {
  name            = "rag-search"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 90

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.service.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.service.arn
    container_name   = "service"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.http]
}
