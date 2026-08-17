FROM node:24-slim AS build
WORKDIR /app
# .git is not in the build context; husky's prepare script would fail without
# a git repo, so disable it.
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
