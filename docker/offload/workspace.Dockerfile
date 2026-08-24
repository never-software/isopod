FROM isopod-offload-source-only:1

WORKDIR /workspace

CMD ["/bin/sh", "-lc", "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done"]
