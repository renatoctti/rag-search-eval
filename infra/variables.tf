variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "image" {
  description = "Container image of the search service, built and published by .github/workflows/image.yml."
  type        = string
  default     = "ghcr.io/renatoctti/rag-search-eval:latest"
}

variable "alarm_email" {
  description = "Where the alarms are sent. Empty creates the topic with no subscriber."
  type        = string
  default     = ""
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.micro is the smallest and is in the free tier of most accounts."
  type        = string
  default     = "db.t4g.micro"
}
