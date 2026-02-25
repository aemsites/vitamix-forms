#!/bin/bash

# Publish IO Events form.submitted event

api_key=$AIO_S2S_API_KEY
provider_id=$AIO_EVENTS_PROVIDER_ID
timestamp=$(date +%s)

oauth_s2s_token=$(curl -s -X POST 'https://ims-na1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "client_id=${AIO_S2S_API_KEY}&client_secret=${AIO_S2S_CLIENT_SECRET}&grant_type=client_credentials&scope=${AIO_S2S_SCOPES}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Publishing form.submitted event"

curl --request POST \
  --url https://eventsingress.adobe.io/ \
  --header "Authorization: Bearer $oauth_s2s_token" \
  --header 'Content-Type: application/cloudevents+json' \
  --header "x-api-key: $api_key" \
  --data "{
    \"datacontenttype\": \"application/json\",
    \"specversion\": \"1.0\",
    \"source\": \"urn:uuid:$provider_id\",
    \"type\": \"form.submitted\",
    \"id\": \"$timestamp\",
    \"data\": {\"formId\":\"test\",\"data\":{\"test\":true}}
  }"