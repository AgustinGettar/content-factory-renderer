FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends blender ffmpeg fonts-dejavu-core ca-certificates libegl1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY lib ./lib
COPY blender ./blender
COPY assets ./assets
COPY test ./test
RUN node --check server.js && npm test
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm","start"]
