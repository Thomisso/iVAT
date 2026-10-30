# Disposable Linux command runner for Docker Desktop; never deployed to Roští.
FROM docker:28-cli
RUN apk add --no-cache bash util-linux coreutils openssh
ENTRYPOINT ["bash"]
