FROM node:20-bullseye
WORKDIR /app
COPY package*.json ./
# Install build dependencies for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install
COPY . .
EXPOSE 8080 8081
CMD ["node", "index.js"]
