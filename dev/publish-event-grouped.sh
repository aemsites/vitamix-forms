#!/bin/bash

# Publish IO Events form.grouped event

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
oauth_s2s_token=$AIO_S2S_TOKEN
provider_id=$AIO_EVENTS_PROVIDER_ID
timestamp=$(date +%s)

echo "Publishing event for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url https://eventsingress.adobe.io/ \
  --header 'Authorization: Bearer $oauth_s2s_token' \
  --header 'Content-Type: application/cloudevents+json' \
  --header 'x-api-key: $api_key' \
  --data '{
    "datacontenttype": "application/json",
    "specversion": "1.0",
    "source": "urn:uuid:$provider_id",
    "type": "form.grouped",
    "id": "$timestamp",
    "data": "{\"formId\": \"123\", \"submissions\": [{\"name\": \"John Doe\", \"email\": \"john.doe@example.com\"}]}"
  }'