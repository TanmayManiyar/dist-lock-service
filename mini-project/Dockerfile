FROM node:22-alpine
WORKDIR /app
COPY package.json node.js server.js ./
COPY public ./public
RUN mkdir -p /data
ENV DATA_DIR=/data
# default: gateway. Replicas override the command: node node.js <id> <clusterSize> /data
CMD ["node", "server.js"]
