FROM ghcr.io/evokoa/pgcontext@sha256:af620ccb420dc355f14ec6beb85503895d394d53ca692dfb14046baca5f59259 AS context
FROM ghcr.io/evokoa/pggraph@sha256:2c85eb0f6b3abe5701edaa9cdb0265da56efd7bbb5202108113d02db8bd6faf5
COPY --from=context /usr/lib/postgresql/17/lib/pgcontext.so /usr/lib/postgresql/17/lib/
COPY --from=context /usr/share/postgresql/17/extension/pgcontext* /usr/share/postgresql/17/extension/
