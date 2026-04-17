# ---------- S3 bucket for static frontend ----------

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${data.aws_caller_identity.current.account_id}"

  tags = {
    Project = var.project_name
  }
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend" {
  bucket     = aws_s3_bucket.frontend.id
  depends_on = [aws_s3_bucket_public_access_block.frontend]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.frontend.arn}/*"
      }
    ]
  })
}

# ---------- Upload frontend files ----------

resource "aws_s3_object" "index_html" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "index.html"
  source       = "${path.module}/../frontend/index.html"
  content_type = "text/html"
  etag         = filemd5("${path.module}/../frontend/index.html")
}

resource "aws_s3_object" "style_css" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "style.css"
  source       = "${path.module}/../frontend/style.css"
  content_type = "text/css"
  etag         = filemd5("${path.module}/../frontend/style.css")
}

resource "aws_s3_object" "app_js" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "app.js"
  source       = "${path.module}/../frontend/app.js"
  content_type = "application/javascript"
  etag         = filemd5("${path.module}/../frontend/app.js")
}

# Generated config with the API endpoint URL
resource "aws_s3_object" "config_js" {
  bucket       = aws_s3_bucket.frontend.id
  key          = "config.js"
  content      = "const API_BASE_URL = '${aws_apigatewayv2_api.main.api_endpoint}';"
  content_type = "application/javascript"
}
