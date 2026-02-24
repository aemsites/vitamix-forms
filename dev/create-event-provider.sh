#!/bin/bash

# Create IO Events Provider

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
oauth_s2s_token=$AIO_S2S_TOKEN

echo "Creating event provider for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url https://api.adobe.io/events/60038/4566206088345592037/4566206088345624684/providers \
  --header "Authorization: Bearer $oauth_s2s_token" \
  --header 'Content-Type: application/json' \
  --header 'x-api-key: $api_key' \
  --data '{
	"label": "vitamix form events",
	"description": "events associated with forms",
	"docs_url": "https://github.com/aemsites/vitamix-forms/blob/main/README.md"
}'