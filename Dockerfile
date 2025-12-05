# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package.json yarn.lock ./

# Install dependencies - skip optional native modules for faster builds
RUN yarn install --frozen-lockfile --ignore-optional

# Copy source files
COPY . .

# Build the Vite frontend
ARG VITE_REOWN_PROJECT_ID
ENV VITE_REOWN_PROJECT_ID=${VITE_REOWN_PROJECT_ID}
RUN yarn build

# Production stage
FROM node:20-alpine

RUN apk add --no-cache tini

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package.json yarn.lock ./

# Install production dependencies only, skip optional native modules
RUN yarn install --frozen-lockfile --production --ignore-optional && \
    yarn cache clean

# Copy built frontend
COPY --from=builder /app/dist ./dist

# Copy backend files
COPY faucet.js config.js ./
COPY src ./src

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8088

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "faucet.js"]
