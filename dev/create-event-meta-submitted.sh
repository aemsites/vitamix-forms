#!/bin/bash

# Create IO Events Provider Metadata for `form.submitted` event

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
oauth_s2s_token=$AIO_S2S_TOKEN
provider_id=$AIO_EVENTS_PROVIDER_ID

echo "Creating event provider for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url https://api.adobe.io/events/${consumer_id}/${project_id}/${workspace_id}/providers/${provider_id}/eventmetadata \
  --header 'Authorization: Bearer $oauth_s2s_token' \
  --header 'Content-Type: application/json' \
  --header 'x-api-key: $api_key' \
  --data '{
	"event_code": "form.submitted",
	"label": "form submitted event",
	"description": "form submitted event"
}'