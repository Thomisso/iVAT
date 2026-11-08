# Disposable Linux command runner for Docker Desktop; never deployed to Roští.
FROM docker:28-cli
RUN apk add --no-cache bash util-linux coreutils openssh
RUN mkdir /opt/ivat-busybox && ln -s /bin/busybox /opt/ivat-busybox/timeout && ln -s /bin/busybox /opt/ivat-busybox/flock
ENTRYPOINT ["bash"]
