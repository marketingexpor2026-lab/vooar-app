FROM node:20-slim

# Build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json ./
RUN npm install

# Copy app source
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
