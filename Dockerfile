# k6 runner image (a container job on Cloud Run Jobs or any scheduler). Pin the k6 version so
# reports across runs are comparable.
FROM grafana/k6:1.3.0

WORKDIR /perf
COPY lib/ lib/
COPY scenarios/ scenarios/
COPY fixtures/ fixtures/
COPY scripts/entrypoint.sh /perf/entrypoint.sh

# /results = a mounted volume (e.g. a GCS bucket); everything lives under perf/.
ENV PERF_RESULTS_DIR=/results/perf

ENTRYPOINT ["/bin/sh", "/perf/entrypoint.sh"]
