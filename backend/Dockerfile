FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /app/data
ENV PORT=8788 DATA_FILE=/app/data/relay-state.json
EXPOSE 8788
CMD ["node", "src/server.js"]
