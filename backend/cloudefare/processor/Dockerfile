# NISAR processor: reads one scene from ASF by HTTP range requests and writes map tiles.
# Runs as a Cloudflare Container (see processor.js), one scene at a time.
FROM --platform=linux/amd64 python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# rasterio's wheel bundles GDAL but needs the system XML parser.
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY *.py ./
EXPOSE 8080
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
