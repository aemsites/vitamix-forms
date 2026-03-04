#!/bin/bash

# Create IO Events Provider

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_PROJECT_WORKSPACE_ID_PROD
api_key=$AIO_CLIENTID_PROD

oauth_s2s_token=$(curl -s -X POST 'https://ims-na1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "client_id=${AIO_CLIENTID_PROD}&client_secret=${AIO_CLIENTSECRET_PROD}&grant_type=client_credentials&scope=${AIO_SCOPES}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Creating event provider for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url "https://api.adobe.io/events/${consumer_id}/${project_id}/${workspace_id}/providers" \
  --header "Authorization: Bearer $oauth_s2s_token" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: $api_key" \
  --data '{
	"label": "vitamix form events",
	"description": "events associated with forms",
	"docs_url": "https://github.com/aemsites/vitamix-forms/blob/main/README.md"
}'