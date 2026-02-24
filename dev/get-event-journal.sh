#!/bin/bash

# Get IO Events Journal

consumer_id=$AIO_CONSUMER_ID
project_id=$AIO_PROJECT_ID
workspace_id=$AIO_WORKSPACE_ID
api_key=$AIO_S2S_API_KEY
oauth_s2s_token=$AIO_S2S_TOKEN
journal_url=$AIO_JOURNAL_URL # comes from response from create-journal-registration.sh
org_id=$AIO_ORG_ID

curl --request GET \
  --url $journal_url \
  --header 'Authorization: Bearer $oauth_s2s_token' \
  --header 'x-api-key: $api_key' \
  --header 'x-ims-org-id: $org_id'