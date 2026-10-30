FROM supabase/postgres:17.6.1.136
RUN cp -a /etc/postgresql-custom /opt/ivat-postgresql-defaults
COPY webhooks.sql /docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql
COPY roles.sql /docker-entrypoint-initdb.d/init-scripts/99-roles.sql
COPY jwt.sql /docker-entrypoint-initdb.d/init-scripts/99-jwt.sql
COPY entrypoint.sh /usr/local/bin/ivat-db-entrypoint.sh
ENTRYPOINT ["sh", "/usr/local/bin/ivat-db-entrypoint.sh"]
