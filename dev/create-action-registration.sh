#!/bin/bash

# Create IO Events Action Registration for form.submitted events
# These events are fired when a form is submitted
# The registration triggers the processor action

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
provider_id=$AIO_EVENTS_PROVIDER_ID

oauth_s2s_token=$(curl -s -X POST 'https://ims-na1.adobelogin.com/ims/token/v3' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "client_id=${AIO_S2S_API_KEY}&client_secret=${AIO_S2S_CLIENT_SECRET}&grant_type=client_credentials&scope=${AIO_S2S_SCOPES}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

echo "Creating registration for consumer_id: $consumer_id, project_id: $project_id, workspace_id: $workspace_id"

curl --request POST \
  --url "https://api.adobe.io/events/${consumer_id}/${project_id}/${workspace_id}/registrations" \
  --header 'Accept: application/hal+json' \
  --header "Authorization: Bearer $oauth_s2s_token" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: $api_key" \
  --data "{
	\"client_id\": \"$api_key\",
	\"runtime_action\": \"forms/processor\",
	\"name\": \"form submitted events action registration\",
	\"description\": \"action registration for form submissions\",
	\"delivery_type\": \"webhook\",
	\"events_of_interest\": [
		{
			\"provider_id\": \"$provider_id\",
			\"event_code\": \"form.submitted\"
		}
	]
}"