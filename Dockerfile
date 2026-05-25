FROM node:20-slim

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y \
    python3 \
        make \
            g++ \
                pkg-config \
                    && rm -rf /var/lib/apt/lists/*

                    WORKDIR /app

                    # Copy package files
                    COPY package*.json ./

                    # Install dependencies with native compilation
                    RUN npm install

                    # Copy app source
                    COPY . .

                    EXPOSE 3000

                    CMD ["node", "server.js"]
