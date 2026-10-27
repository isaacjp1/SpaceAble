FROM python:3.12-slim
WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app
RUN pip install --no-cache-dir . && useradd --create-home planner
USER planner
# Set PLANNER_SHARED_SECRET at deploy time (same value as the web app's). Never bake it in.
ENV PLANNER_CORS_ORIGINS=http://localhost:3000
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
