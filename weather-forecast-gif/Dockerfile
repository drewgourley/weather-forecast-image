ARG BUILD_FROM
FROM $BUILD_FROM

ENV LANG C.UTF-8
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apk add --no-cache \
    nodejs \
    npm \
    cairo-dev \
    pango-dev \
    jpeg-dev \
    giflib-dev \
    build-base \
    g++ \
    python3

COPY package.json /
RUN cd / && npm install --unsafe-perm --omit=dev

COPY index.js /
COPY icons /icons
COPY letters /letters
COPY numbers /numbers
COPY punctuation /punctuation

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
