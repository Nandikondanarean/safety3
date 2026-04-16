# Use a slim Node.js image for building
FROM node:18-slim AS builder

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (only production if possible, but keeping it general for now)
RUN npm install

# Copy application source
COPY . .

# Production stage
FROM node:18-slim

WORKDIR /app

# Copy only the necessary files from builder
COPY --from=builder /app /app

# Expose the port the app runs on (assuming 3000 as a standard, or checking server.js)
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
