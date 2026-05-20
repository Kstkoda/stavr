# stavR — Observability Metrics Spec

> The metric catalog behind the Diagnostics page. ~170 metrics across 6 layers + the telemetry pipeline. Adopted **2026-05-20** as a **forward-target spec**: the full catalog is the long-term shape; stavR-applicable layers get instrumented and rendered now, the rest stay documented-but-dormant. This spec is task #60 and it drives the Diagnostics page rebuild (task #72 — the v0.6.12 Diagnostics rework the operator judged a failure, in large part because it had no real metric model behind it).

## How to read this

- **Type** — C = counter, G = gauge, H = histogram.
- **Applies** — declared per layer. `now` = stavR has this surface today · `partial` = some rows map, some don't · `dormant` = kept as a forward target; stavR has no such surface yet (Kubernetes, cloud LBs, federated learning).
- **Emitted today** — declared per layer. The honest baseline: of the ~170 names below, stavR currently emits **none under their canonical names** — it emits 9 related metrics under stavR-specific names (see Baseline). Everything else is to-wire.
- Names follow OpenTelemetry GenAI/MCP semantic conventions and NVIDIA DCGM where standards exist; vendor-neutral descriptive names otherwise.
- Thresholds are **starting points** — tune to hardware, SLAs, and observed baselines.
- **Build approach (operator pick, 2026-05-20):** the Diagnostics page is designed around the *whole* scoped catalog now; every not-yet-instrumented metric renders with an honest "not wired yet" state. Instrumentation lands in waves behind the finished layout.

## Baseline — what stavR emits today

Nine custom Prometheus metrics (`src/observability/metrics.ts` + `event-loop.ts`), plus Node process defaults (`prom-client` `collectDefaultMetrics`), plus OTel GenAI spans (ADR-031):

| Current metric | Type | Maps toward |
|---|---|---|
| `stavr_http_request_duration_seconds` | H | L5 `mcp.gateway.request.duration` |
| `stavr_sse_sessions` | G | L5 `mcp.server.sessions.active` (note: stale name — transport is Streamable HTTP since ADR-044) |
| `stavr_events_emitted_total` | C | internal / cross-cutting |
| `stavr_workers_alive` | G | stavR-specific (worker roster) |
| `stavr_bom_state` | G | stavR-specific (BOM lifecycle) |
| `stavr_provider_requests_total` | C | L4 `llm_requests_per_sec` |
| `stavr_provider_latency_seconds` | H | L4 `gen_ai.server.request.duration` |
| `stavr_eventloop_lag_seconds` | H | runtime health (L1-adjacent) |
| `nodejs_eventloop_utilization` | G | runtime health (L1-adjacent) |
| `prom-client` defaults | mixed | process-level CPU/mem/GC/handles (NOT host-level L1) |

That is the entire real substrate. The rest of this spec is the target.

## Two rules that override individual thresholds

1. **Burn-rate alerts first.** Before wiring any static threshold, define the SLOs and wire a **multi-window burn-rate alert** per SLO (`slo.error_budget.burn_rate`). One burn-rate alert replaces dozens of static thresholds and is the single biggest signal-to-noise win. This is Wave 0.
2. **Cardinality discipline.** Safe labels: `tool`, `model`, `upstream`, `error.type`, `host`, `gpu` — all bounded. **Never** add `request_id`, `user_id`, `session_id`, or any unbounded identifier as a label — it explodes TSDB series count and is the most common way a metrics stack falls over.

---

## Layer 1 — Servers / hosts (USE) · applies: now · emitted today: none (host-level needs a node-exporter; only process-level defaults exist)

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| node_cpu_utilization_pct | G | host, core | Warn >85% for 5m |
| node_cpu_load_per_core | G | host | Warn >1.0 (run-queue saturation) |
| node_cpu_steal_pct | G | host | Warn >5% (noisy-neighbor) |
| node_cpu_throttled_pct | G | host, container | Warn >25% of periods |
| node_context_switches_per_sec | C | host | Anomaly vs baseline |
| node_memory_used_pct | G | host | Warn >90% |
| node_memory_available_bytes | G | host | Page <5% of total |
| node_swap_used_pct | G | host | Page >0 on swap-off hosts |
| node_memory_major_page_faults_per_sec | C | host | Anomaly vs baseline |
| node_oom_kills_total | C | host | Page on any increase |
| node_disk_space_used_pct | G | host, mount | Warn >85%, page >95% |
| node_disk_inodes_used_pct | G | host, mount | Warn >85% |
| node_disk_io_latency_seconds | H | host, device | Warn p99 >100ms (SSD) |
| node_disk_iops | G | host, device | Warn >80% of provisioned |
| node_disk_queue_depth | G | host, device | Warn sustained >2× cores |
| node_disk_errors_total | C | host, device | Page on any increase |
| node_network_throughput_bytes | C | host, iface, dir | Warn >80% NIC capacity |
| node_network_errors_total | C | host, iface | Warn on any increase |
| node_network_drops_total | C | host, iface | Warn on any increase |
| node_tcp_retransmits_per_sec | C | host | Warn >1% of segments |
| node_conntrack_used_pct | G | host | Warn >80% |
| node_filefd_used_pct | G | host | Warn >80% |
| node_clock_skew_seconds | G | host | Warn >100ms |
| node_boot_time_seconds | G | host | Alert on unexpected reset |
| node_hw_temperature_celsius | G | host, sensor | Vendor spec |
| node_ram_ecc_errors_total | C | host | Warn on any increase |

## Layer 2 — GPUs (DCGM) · applies: now (local-LLM machines) · emitted today: none (needs the NVIDIA DCGM exporter)

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| DCGM_FI_DEV_GPU_UTIL | G | gpu, host | Info; low on a paid GPU = waste |
| DCGM_FI_PROF_SM_ACTIVE | G | gpu | Low = pipeline stall |
| DCGM_FI_PROF_PIPE_TENSOR_ACTIVE | G | gpu | Productive ML work indicator |
| DCGM_FI_DEV_MEM_COPY_UTIL | G | gpu | Info |
| DCGM_FI_PROF_DRAM_ACTIVE | G | gpu | High = memory-bandwidth bound |
| DCGM_FI_DEV_FB_USED | G | gpu | — |
| DCGM_FI_DEV_FB_FREE | G | gpu | Page <5% of total VRAM |
| DCGM_FI_DEV_GPU_TEMP | G | gpu | Warn >85°C |
| DCGM_FI_DEV_MEMORY_TEMP | G | gpu | Warn >95°C (HBM) |
| DCGM_FI_DEV_POWER_USAGE | G | gpu | Warn sustained near cap |
| DCGM_FI_DEV_CLOCK_THROTTLE_REASONS | G | gpu | Warn on thermal/power throttle bits |
| DCGM_FI_DEV_SM_CLOCK | G | gpu | Warn drop below base clock |
| DCGM_FI_DEV_XID_ERRORS | G | gpu | Page on any |
| DCGM_FI_DEV_ECC_SBE_VOL_TOTAL | C | gpu | Warn on rising trend |
| DCGM_FI_DEV_ECC_DBE_VOL_TOTAL | C | gpu | Page on any increase |
| DCGM_FI_DEV_ROW_REMAP_PENDING | G | gpu | Warn >0 |
| DCGM_FI_DEV_ROW_REMAP_FAILURE | G | gpu | Page >0 (RMA the GPU) |
| DCGM_FI_DEV_UNCORRECTABLE_REMAPPED_ROWS | C | gpu | Page on any increase |
| DCGM_FI_DEV_PCIE_REPLAY_COUNTER | C | gpu | Warn on increase |
| DCGM_FI_PROF_NVLINK_TX_BYTES / RX_BYTES | C | gpu, link | Capacity tracking |
| DCGM_FI_DEV_NVLINK_CRC_FLIT_ERROR_COUNT | C | gpu, link | Warn on increase |
| DCGM_FI_PROF_PCIE_TX_BYTES / RX_BYTES | C | gpu | Capacity tracking |
| DCGM_FI_DEV_THERMAL_VIOLATION | C | gpu | Warn on increase |
| DCGM_FI_DEV_POWER_VIOLATION | C | gpu | Warn on increase |
| gpu_process_memory_bytes | G | gpu, pid | Per-job attribution |

## Layer 3 — Cloud / platform · applies: dormant · emitted today: none

stavR runs as a local daemon — no Kubernetes, no cloud load balancers, no managed object store or DB. This entire layer is a **forward target**: kept documented in case stavR ever runs hosted or multi-tenant. Not scheduled for instrumentation. The Diagnostics page renders this layer collapsed as "not applicable — local deployment."

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| cloud_quota_used_pct | G | service, region, quota | Warn >80% |
| cloud_spend_rate_usd | G | service, tag | Alert on budget burn rate |
| lb_request_count | C | lb | Capacity / RED rate |
| lb_latency_seconds | H | lb | SLO p99 |
| lb_http_5xx_ratio | G | lb | Warn >1% |
| lb_healthy_host_count | G | lb, target_group | Page below min N |
| lb_surge_queue_length | G | lb | Warn >0 |
| objstore_request_errors_total | C | bucket | Warn ratio >1% |
| objstore_throttle_total | C | bucket | Warn on increase |
| db_connections_used_pct | G | db | Warn >80% |
| db_replication_lag_seconds | G | db, replica | Warn >10s |
| db_iops_credit_balance | G | db | Warn on low balance |
| nat_gateway_throughput_bytes | C | region | Warn >80% of limit |
| cross_region_transfer_bytes | C | src, dst | Cost + latency tracking |
| cloud_api_throttled_total | C | service | Warn on increase |
| k8s_node_not_ready | G | cluster, node | Page >0 |
| k8s_pod_restarts_total | C | namespace, pod | Warn >5 in 10m |
| k8s_pod_oomkilled_total | C | namespace, pod | Warn on any |
| k8s_pods_pending | G | cluster | Warn sustained >5m |
| k8s_pod_crashloop | G | namespace, pod | Page >0 |
| k8s_hpa_desired_vs_current | G | hpa | Warn on sustained mismatch |
| k8s_resource_usage_vs_requests | G | namespace | Efficiency tracking |
| k8s_apiserver_latency_seconds | H | cluster | SLO p99 |
| k8s_pv_used_pct | G | pvc | Warn >85% |

## Layer 4 — LLM / AI execution (OTel GenAI) · applies: now · emitted today: 2 partial (`stavr_provider_requests_total`, `stavr_provider_latency_seconds` — reshape to the names below)

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| gen_ai.client.token.usage | H | model, token.type | Cost tracking |
| gen_ai.client.operation.duration | H | model, operation | SLO p95 |
| gen_ai.client.operation.time_to_first_chunk | H | model | SLO p95 (streaming TTFT) |
| gen_ai.client.operation.time_per_output_chunk | H | model | SLO p95 |
| gen_ai.server.request.duration | H | model | SLO p95 |
| gen_ai.server.time_to_first_token | H | model | SLO p95 (e.g. <500ms) |
| gen_ai.server.time_per_output_token | H | model | SLO p95 (e.g. <50ms) |
| llm_requests_per_sec | C | model | Capacity tracking |
| llm_prompt_tokens_per_sec | G | model | Capacity tracking |
| llm_generation_tokens_per_sec | G | model | Capacity tracking |
| llm_requests_waiting | G | model | Warn sustained >0 |
| llm_requests_running | G | model | Warn near max batch |
| llm_queue_time_seconds | H | model | SLO p95 |
| llm_batch_size | H | model | Utilization tracking |
| llm_request_preemptions_total | C | model | Warn on increase |
| llm_kv_cache_utilization_pct | G | model | Warn >90% |
| llm_prefix_cache_hit_rate | G | model | Low = prompt-structure tuning |
| llm_kv_cache_evictions_total | C | model | Anomaly vs baseline |
| llm_requests_swapped | G | model | Warn >0 |
| llm_request_errors_total | C | model, error.type | Warn ratio >1% |
| llm_finish_reason_total | C | model, reason | Watch length / content_filter share |
| llm_context_length_exceeded_total | C | model | Warn on increase |
| llm_guardrail_blocks_total | C | model, policy | Track rate |
| llm_output_schema_invalid_total | C | model | Warn on ratio |
| llm_eval_groundedness_score | G/H | model | Alert below quality floor |
| llm_eval_toxicity_flags_total | C | model | Warn on increase |
| llm_refusal_rate | G | model | Track |
| llm_input_drift_score | G | model | Alert above drift threshold |
| llm_output_drift_score | G | model | Alert above drift threshold |
| llm_cost_usd_per_request | H | model, tenant | Track |
| llm_cost_usd_total | C | model, tenant, feature | Budget tracking |

## Layer 5 — MCP gateway / server / client · applies: now — **this is stavR's core** · emitted today: 2 partial (`stavr_http_request_duration_seconds`, `stavr_sse_sessions`)

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| mcp.gateway.request.duration | H | upstream, tool | SLO p99 |
| mcp.gateway.request.rate | C | upstream, tool, client | Capacity tracking |
| mcp.gateway.request.errors | C | upstream, error.type | Warn ratio >1% |
| mcp.gateway.upstream.connections.active | G | upstream | Warn near pool max |
| mcp.gateway.upstream.connections.queued | G | upstream | Warn >0 |
| mcp.gateway.circuit_breaker.state | G | upstream | Page on open |
| mcp.gateway.rate_limit.hits | C | tenant | Track |
| mcp.gateway.upstream.health | G | upstream | Page on unhealthy |
| mcp.gateway.tool.invocations | C | client, tool, server | Usage analytics |
| mcp.gateway.auth.failures | C | client | Warn on spike |
| mcp.server.tool.duration | H | tool | SLO p95 per tool |
| mcp.server.tool.errors | C | tool, error.type | Warn ratio >1% |
| mcp.server.tool.invocations | C | tool | Usage tracking |
| mcp.server.invocations.in_flight | G | server | Warn near capacity |
| mcp.server.sessions.active | G | server | Capacity tracking |
| mcp.server.downstream.duration | H | tool, dependency | SLO p95 |
| mcp.server.downstream.errors | C | tool, dependency | Warn ratio |
| mcp.server.cold_start.duration | H | server | SLO (serverless) |
| mcp.server.protocol.violations | C | type | Warn on any |
| mcp.client.tool.duration | H | tool, server | SLO p95 |
| mcp.client.tool.errors | C | tool, error.type | Warn ratio |
| mcp.client.connection.state | G | server | Page on disconnected |
| mcp.client.reconnect.attempts | C | server | Warn on spike |
| mcp.client.schema.validation.failures | C | server, tool | Warn on any |
| mcp.client.tool.timeouts | C | tool | Warn on ratio |
| mcp.client.tool.result.tokens | H | tool | Context-bloat tracking |
| mcp.client.list_tools.duration | H | server | SLO p95 |
| mcp.jsonrpc.errors | C | code | Watch distribution |
| mcp.protocol.version_mismatch | C | peer | Warn on any |

## Layer 6 — Federated / distributed cluster · applies: partial

stavR's federation is `peers.yaml` + an mDNS/ping reconciler — **not** a job-scheduling consensus cluster, and **not** federated learning. Split accordingly:

### 6a · `cluster.*` — applies: partial · emitted today: none

A handful map to stavR's peer federation (`nodes.by_state`, `internode.rtt`, `intersite.*`, `clock_skew`); the scheduler / consensus / sharding rows are dormant — stavR has no scheduler, no consensus quorum, no sharded replication.

| Metric | T | Key labels | Threshold / alert | Applies |
|---|---|---|---|---|
| cluster.nodes.by_state | G | site, state | Page on unreachable >0 | now |
| cluster.internode.rtt_seconds | H | src_site, dst_site | Warn p99 above baseline | now |
| cluster.intersite.bandwidth_used_pct | G | link | Warn >80% | now |
| cluster.intersite.packet_loss_pct | G | link | Warn >0.1% | now |
| cluster.network.partitions_total | C | — | Page on any | now |
| cluster.clock_skew_seconds | G | node | Warn >100ms | now |
| cluster.scheduler.latency | H | — | SLO p95 | dormant |
| cluster.jobs.pending | G | site | Warn sustained backlog | dormant |
| cluster.scheduling.failures | C | reason | Warn on increase | dormant |
| cluster.jobs.completed_total | C | status | RED rate for jobs | dormant |
| cluster.job.duration | H | job.type | SLO | dormant |
| cluster.job.retries | C | job.type | Warn on ratio | dormant |
| cluster.data_locality.hit_rate | G | — | Low = network-cost risk | dormant |
| cluster.consensus.round.latency | H | — | Warn p99 above baseline | dormant |
| cluster.consensus.leader_elections | C | — | Warn on spike | dormant |
| cluster.consensus.quorum_lost | C | — | Page on any | dormant |
| cluster.replication.lag | G | shard | Warn above threshold | dormant |

### 6b · `fl.*` — applies: dormant (federated **learning** — N/A)

federated-learning metrics (FedAvg rounds, privacy-epsilon budgets, poisoning detection via update norms). stavR brokers tools across peers; it does not train a shared model. This whole block is documented as a forward target only — not scheduled, not rendered.

`fl.round.duration` · `fl.time_to_target_accuracy` · `fl.clients.selected` · `fl.clients.successful` · `fl.effective_update_ratio` · `fl.stragglers.count` · `fl.client.dropout_total` · `fl.client.availability_pct` · `fl.update.staleness` · `fl.aggregation.duration` · `fl.aggregation.stalls` · `fl.comm.bytes_per_client` · `fl.global.loss` · `fl.global.accuracy` · `fl.update.norm` · `fl.updates.rejected` · `fl.privacy.epsilon_consumed`

## Cross-cutting — telemetry pipeline & SLOs · applies: now · emitted today: partial (stavR has OTel per ADR-031)

| Metric | T | Key labels | Threshold / alert |
|---|---|---|---|
| otel.collector.spans.dropped | C | collector | Warn on any |
| otel.collector.metrics.dropped | C | collector | Warn on any |
| otel.exporter.queue.size | G | exporter | Warn >80% |
| monitoring.scrape.failures | C | target | Warn >0 |
| telemetry.ingestion.lag_seconds | G | pipeline | Warn >60s |
| trace.completeness_pct | G | service | Warn <95% (orphan spans) |
| tsdb.active_series | G | — | Cardinality watch |
| slo.error_budget.burn_rate | G | slo | Page >14.4× (fast), warn >1× (slow) |
| synthetic.probe.success | G | probe | Page on failure |

---

## Diagnostics page mapping

The page is rebuilt around this catalog (drives task #72). Structure:

- **Top band — SLO health.** `slo.error_budget.burn_rate` per SLO, prominent. This is the first thing the operator sees and the first thing wired (Wave 0).
- **Layer tiles.** One tile per *applicable* layer — Host (L1), GPU (L2), LLM (L4), MCP Gateway (L5), Federation (L6a), Telemetry (cross-cutting). Each tile: a layer-health rollup + drill into the layer's metric table.
- **Layer 3 (cloud) + Layer 6b (fl.\*)** render collapsed under a single "Dormant — not applicable to this deployment" expander, so the catalog is visible/complete without implying stavR has those surfaces.
- **Honest placeholders.** Every metric not yet emitting renders greyed with a "not wired yet" chip and its target instrumentation wave. No fabricated values, ever — this is the operator's pick and the correction to the v0.6.12 failure.

## Instrumentation waves

Ordered by signal-to-noise and cost. Each wave is a candidate BOM.

- **Wave 0 — SLO + telemetry-pipeline health.** Define stavR's SLOs; wire `slo.error_budget.burn_rate` multi-window alerts + the `otel.collector.*` / `trace.completeness_pct` / `tsdb.active_series` self-monitoring. Per Rule 1 — biggest win, smallest surface.
- **Wave 1 — Layer 5 (MCP gateway).** stavR *is* the gateway, so these are the cheapest and most core. Reshape `stavr_http_request_duration_seconds` → `mcp.gateway.request.duration`, `stavr_sse_sessions` → `mcp.server.sessions.active`; add the rest of L5.
- **Wave 2 — Layer 1 (host USE).** Bundle or co-deploy a node-exporter-equivalent; host-level USE metrics. Mostly standard, low novelty.
- **Wave 3 — Layer 4 (LLM execution).** Promote `stavr_provider_*` to OTel GenAI conventions; add the vLLM-style queue / KV-cache / batch metrics for local models.
- **Wave 4 — Layer 2 (GPU/DCGM).** Deploy the NVIDIA DCGM exporter on the local-LLM machines; scrape it. Depends on the family-mode machine rollout.
- **Dormant — Layer 3, Layer 6b (fl.\*), and the consensus/scheduler rows of 6a.** Not scheduled. Documented as forward target.

## Cross-references

- ADR-031 — observability architecture (OTel + Prometheus + pino baseline).
- Task #60 — this spec. Task #72 — the Diagnostics page rebuild this drives.
- `project_stavr_next_cycle_family_mode_functional` — Wave 4 (GPU) depends on the family machine rollout.
