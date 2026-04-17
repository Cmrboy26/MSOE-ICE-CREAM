resource "aws_dynamodb_table" "main" {
  name           = "${var.project_name}-table"
  billing_mode   = "PROVISIONED"
  read_capacity  = 25
  write_capacity = 25
  hash_key       = "pk"
  range_key      = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  tags = {
    Project = var.project_name
  }
}

# Seed data (ice_cream_listing and ice_cream_metadata) already exists in DynamoDB.
# aws_dynamodb_table_item does not support import, so seed items are managed
# outside of Terraform. See scripts/seed_history.py for reference.
