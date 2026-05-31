FROM node:22-bookworm
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY dist/ ./dist/
ENTRYPOINT ["node", "dist/run.js"]
