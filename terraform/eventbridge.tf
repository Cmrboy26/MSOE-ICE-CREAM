# Nightly compaction: runs at 06:00 UTC = 00:00 US Central (CST)
# During CDT it runs at 01:00 Central, which is close enough.
resource "aws_cloudwatch_event_rule" "nightly_compact" {
  name                = "${var.project_name}-nightly-compact"
  description         = "Trigger daily compaction of yesterday's reports"
  schedule_expression = "cron(0 6 * * ? *)"

  tags = {
    Project = var.project_name
  }
}

resource "aws_cloudwatch_event_target" "compact_lambda" {
  rule      = aws_cloudwatch_event_rule.nightly_compact.name
  target_id = "CompactLambda"
  arn       = aws_lambda_function.api.arn
}

resource "aws_lambda_permission" "eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.nightly_compact.arn
}
