FROM node:24-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/papercolab-runtime \
    && install -d -o node -g node -m 0700 /var/lib/papercolab

ENV PATH="/opt/papercolab-runtime/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PAPERCOLAB_DATA=/var/lib/papercolab \
    PORT=8787

RUN pip install --disable-pip-version-check --no-cache-dir 'gunicorn==27.0.1'

WORKDIR /app
COPY server/ server/
COPY scripts/build_worker.py scripts/build_worker.py
COPY scripts/check_build.py scripts/check_build.py
COPY web/ web/
COPY examples/estuary/ examples/estuary/
COPY LICENSE LICENSE
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/papercolab

EXPOSE 8787
ENTRYPOINT ["papercolab"]
CMD ["gunicorn", "--workers", "1", "--threads", "8", "server.wsgi:create_app()"]
