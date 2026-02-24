#!/bin/bash

# Create IO Events Journal Registration for form.submitted events
# These events are fired when a form is submitted
# The journal is consumed on a cron by the form-pump action
# The form-pump groups submissions by form ID and triggers the form-persist action, once for each form ID

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
oauth_s2s_token=$AIO_S2S_TOKEN
provider_id=$AIO_EVENTS_PROVIDER_ID

echo "Creating registration for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url https://api.adobe.io/events/${consumer_id}/${project_id}/${workspace_id}/registrations \
  --header 'Accept: application/hal+json' \
  --header 'Authorization: Bearer $oauth_s2s_token' \
  --header 'Content-Type: application/json' \
  --header 'x-api-key: $api_key' \
  --data '{
	"client_id": "$api_key",
	"name": "form submitted events journal registration",
	"description": "journal for form submissions",
	"delivery_type": "journal",
	"events_of_interest": [
		{
			"provider_id": "$provider_id",
			"event_code": "form.submitted"
		}
	]
}'