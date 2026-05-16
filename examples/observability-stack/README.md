# Local OTel + Prometheus stack for stavr development

A single docker-compose file that brings up:

- **Jaeger** all-in-one with OTLP HTTP receiver on `:4318` and UI on `:16686`.
- **Prometheus** scraping the local stavr daemon's `/metrics` every 5 seconds.

All ports bind to `127.0.0.1`. Nothing leaves the box.

## Usage

```sh
cd examples/observability-stack
docker compose up -d

# In a separate terminal, start stavr with both env vars set:
STAVR_OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental \
  npm start
```

Open:

- Jaeger UI: <http://localhost:16686>
- Prometheus: <http://localhost:9090>

In Jaeger, filter by `Service: stavr` and the canonical OTel GenAI agent spans
(`invoke_agent` → `execute_tool` children) show up under each BOM run.
`Operation: invoke_agent` gives you the per-BOM root view; expand to see the
per-step `execute_tool` children plus any MCP request spans for tool calls.

Useful Prometheus queries:

```promql
# p99 event-loop lag over the last minute
histogram_quantile(0.99, rate(stavr_eventloop_lag_seconds_bucket[1m]))

# Event-loop utilization right now
nodejs_eventloop_utilization

# HTTP request rate by route
sum by (route) (rate(stavr_http_request_duration_seconds_count[1m]))
```

## Teardown

```sh
docker compose down
```

Volumes are ephemeral — nothing persists between runs.
