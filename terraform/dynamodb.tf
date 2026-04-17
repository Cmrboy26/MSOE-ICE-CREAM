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

# Seed: add ice cream machine to the resource listing
resource "aws_dynamodb_table_item" "ice_cream_listing" {
  table_name = aws_dynamodb_table.main.name
  hash_key   = aws_dynamodb_table.main.hash_key
  range_key  = aws_dynamodb_table.main.range_key

  item = jsonencode({
    pk          = { S = "RESOURCES" }
    sk          = { S = "msoe-ice-cream" }
    name        = { S = "MSOE Ice Cream Machine" }
    description = { S = "The ice cream machine in the MSOE campus center" }
  })
}

# Seed: add ice cream machine metadata for status lookups
resource "aws_dynamodb_table_item" "ice_cream_metadata" {
  table_name = aws_dynamodb_table.main.name
  hash_key   = aws_dynamodb_table.main.hash_key
  range_key  = aws_dynamodb_table.main.range_key

  item = jsonencode({
    pk          = { S = "RESOURCE#msoe-ice-cream" }
    sk          = { S = "#METADATA" }
    name        = { S = "MSOE Ice Cream Machine" }
    description = { S = "The ice cream machine in the MSOE campus center" }
  })
}
