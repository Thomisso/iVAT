FROM kong/kong:3.9.3
COPY kong.yml /home/kong/temp.yml
COPY kong-entrypoint.sh /home/kong/kong-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/home/kong/kong-entrypoint.sh"]
