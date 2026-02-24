# vitamix-forms

I/O Runtimes Action handlers for form submissions.

## Process
1. Form submissions are sent via HTTP to `submit` action, body contains `formId` and `data` (submission)
  i. validates payload
  ii. sends a `form.submitted` event to the Journal, contains `formId` and `data`
3. `pump` action runs on a schedule (every 10 minutes)
  i. reads Journal events
  ii. groups by `formId`
  iii. sends `form.grouped` event, containing `formId` and array of submissions
4. `processor` action triggered by `form.grouped` event
  i. reads destination sheet
  ii. appends submissions to sheet
  iii. writes sheet back to storage

## Setup

These steps are performed once for each environment.

1. [Create App Builder project](https://experienceleague.adobe.com/en/docs/experience-manager-learn/cloud-service/asset-compute/set-up/app-builder)
2. Add service to project > `I/O Management API`
3. [Generate OAuth Server-to-Server credentials](https://developer.adobe.com/developer-console/docs/guides/credentials)
4. Set `.env` values using `example.env` template and values from Adobe Developer Console
5. Configure IO Events
  i. [Create Event Provider](./dev/create-event-provider.sh)
    - Response body contains `id` property, set `AIO_EVENTS_PROVIDER_ID` to that value
    
  ii. [Create Provider Metadata](./dev/create-event-meta-submitted.sh) for `form.submitted` event
  iii. [Create Provider Metadata](./dev/create-event-meta-grouped.sh) for `form.grouped` event
  iv. [Create Journal Registration](./dev/create-journal-registration.sh) for `form.submitted` event
    - Response body contains `_links.["rel:events"].href` property, set `AIO_JOURNAL_URL` to that value

### References
- [Creating Runtime Actions](https://developer.adobe.com/app-builder/docs/guides/runtime_guides/creating-actions)
- [Events Registration API](https://developer.adobe.com/events/docs/guides/api/registration-api)
- [Events Journaling API](https://developer.adobe.com/events/docs/guides/api/journaling-api)
- [Events Publishing API](https://developer.adobe.com/events/docs/guides/api/eventsingress-api)
