FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install --no-install-recommends --yes openssh-server ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh fixture

COPY sshd_config /etc/ssh/sshd_config
COPY authorized_keys /tmp/fixture_authorized_keys
COPY entrypoint.sh /usr/local/bin/webssh-fixture

RUN install -d -m 700 -o fixture -g fixture /home/fixture/.ssh \
  && install -m 600 -o fixture -g fixture /tmp/fixture_authorized_keys /home/fixture/.ssh/authorized_keys \
  && rm /tmp/fixture_authorized_keys \
  && chmod 755 /usr/local/bin/webssh-fixture

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/webssh-fixture"]
