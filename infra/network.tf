# The default VPC keeps this small: no NAT gateway, which would cost more than everything else
# here. The tasks get a public IP to pull the image and download SciFact; nothing else can reach
# them except the load balancer, and the database is not reachable from outside the VPC at all.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "alb" {
  name        = "rag-search-alb"
  description = "Load balancer of the search service"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_security_group" "service" {
  name        = "rag-search-service"
  description = "Tasks of the search service"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_security_group" "db" {
  name        = "rag-search-db"
  description = "Database of the search service"
  vpc_id      = data.aws_vpc.default.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from anywhere"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the tasks"
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb" {
  security_group_id            = aws_security_group.service.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "service_out" {
  security_group_id = aws_security_group.service.id
  description       = "Image registry, dataset download and the database"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_service" {
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from the tasks"
  referenced_security_group_id = aws_security_group.service.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
