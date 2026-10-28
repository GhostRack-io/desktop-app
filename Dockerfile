FROM ubuntu:22.04
ARG RUST_VERSION=1.97.0
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential curl ca-certificates git pkg-config file patchelf python3 xz-utils \
    libwebkit2gtk-4.1-dev libgtk-3-dev libxdo-dev libayatana-appindicator3-dev librsvg2-dev \
    libfuse2 xvfb xauth dbus-x11 fonts-dejavu-core xdg-utils desktop-file-utils && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
ENV PATH=/opt/cargo/bin:/usr/local/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain ${RUST_VERSION} && rm /tmp/rustup.sh
ARG NODE_VERSION=24.18.1
RUN curl --proto '=https' --tlsv1.2 -fsS https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz
ENV APPIMAGE_EXTRACT_AND_RUN=1
WORKDIR /src
