FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
