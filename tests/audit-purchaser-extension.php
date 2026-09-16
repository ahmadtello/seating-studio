<?php
// Read-only check of the staged extension against the actual portal booking/order links.
require '/tmp/seating-membership.php';
$eventId = 99001;
$portal = json_decode(file_get_contents('/var/lib/seating-studio/workspaces.json'), true);
$input = [];
foreach ($portal['workspaces'] ?? [] as $workspace) if ((string) ($workspace['details']['mecEventId'] ?? '') === (string) $eventId) {
    foreach ($workspace['guests'] as $guest) if (!empty($guest['bookingId'])) $input[] = ['booking_id' => $guest['bookingId']];
}
$request = new WP_REST_Request('GET', "/mec-utility/v1/events/{$eventId}/attendees/flat");
$request->set_param('include_membership','1');
$result = apply_filters('rest_post_dispatch', new WP_REST_Response(['attendees'=>$input],200), rest_get_server(), $request);
$levels = []; $payments = [];
foreach ($result->get_data()['attendees'] as $a) {
    if ($a['booking_membership']['source'] !== 'woocommerce-purchaser' || $a['booking_membership']['status'] === 'unavailable') throw new RuntimeException('Unverified purchaser');
    foreach ($a['booking_membership']['levels'] as $l) if ($l['active']) $levels[$l['name']] = ($levels[$l['name']] ?? 0) + 1;
    $kind = $a['booking_payment']['kind'];
    $payments[$kind] = ($payments[$kind] ?? 0) + 1;
}
echo json_encode(['records' => count($input), 'purchaser_memberships' => $levels, 'order_classification' => $payments], JSON_PRETTY_PRINT) . PHP_EOL;
if (isset($levels['Membership']) || isset($payments['unverified'])) throw new RuntimeException('Unexpected unresolved records; inspect before release');
