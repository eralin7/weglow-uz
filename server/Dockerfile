FROM denoland/deno:2.9.7
WORKDIR /app
COPY . .
RUN deno cache main.ts
EXPOSE 8080
CMD ["run", "--allow-net", "--allow-env", "--allow-read=/data", "--allow-write=/data", "main.ts"]
