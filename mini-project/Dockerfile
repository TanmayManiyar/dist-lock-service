FROM node:22-alpine
WORKDIR /app
COPY package.json replica.js server.js ./
COPY public ./public
RUN mkdir -p /data
ENV DATA_DIR=/data
# default: gateway. Replicas override the command: node replica.js <id> <clusterSize> /data
CMD ["node", "server.js"]
