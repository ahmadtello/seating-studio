<?php
// Read-only production diagnostic. Execute with wp eval-file; prints aggregates only.
$eventId = 99001;
$portal = json_decode(file_get_contents('/var/lib/seating-studio/workspaces.json'), true);
$guests = [];
foreach ($portal['workspaces'] ?? [] as $workspace) {
    if ((string) ($workspace['details']['mecEventId'] ?? '') === (string) $eventId) $guests = array_merge($guests, $workspace['guests'] ?? []);
}
global $wpdb;
$rows = $wpdb->get_results($wpdb->prepare("SELECT booking_id, user_id FROM {$wpdb->prefix}mec_bookings WHERE event_id = %d", $eventId), ARRAY_A);
$accounts = [];
foreach ($rows as $row) $accounts[(int) $row['booking_id']] = (int) $row['user_id'];
$totals = ['portal_guests' => count($guests), 'linked_order_guests' => 0, 'different_mec_and_order_account' => 0, 'generic_membership_guests' => 0, 'generic_membership_with_different_purchaser' => 0, 'pricing_snapshot_guests' => 0];
$transitions = [];
$cache = [];
foreach ($guests as $guest) {
    $bid = (int) ($guest['bookingId'] ?? 0);
    if (!$bid) continue;
    if (!isset($cache[$bid])) {
        $oid = (int) get_post_meta($bid, 'mec_order_id', true);
        $order = $oid ? wc_get_order($oid) : null;
        $uid = $order ? (int) $order->get_customer_id() : 0;
        $labels = [];
        foreach ($uid ? (array) Ihc_Db::get_user_levels($uid, false) : [] as $level) if (isset($level['is_expired']) && $level['is_expired'] === false) $labels[] = $level['label'];
        $cache[$bid] = ['order' => (bool) $order, 'different' => $uid && $uid !== ($accounts[$bid] ?? 0), 'labels' => $labels, 'snapshot' => (string) get_post_meta($bid, 'seating_studio_pricing_category_label', true)];
    }
    $info = $cache[$bid];
    $current = array_column($guest['bookingMembership']['levels'] ?? [], 'name');
    $generic = in_array('Membership', $current, true);
    $totals['linked_order_guests'] += (int) $info['order'];
    $totals['different_mec_and_order_account'] += (int) $info['different'];
    $totals['generic_membership_guests'] += (int) $generic;
    $totals['generic_membership_with_different_purchaser'] += (int) ($generic && $info['different']);
    $totals['pricing_snapshot_guests'] += (int) ($info['snapshot'] !== '');
    if ($generic) {
        $key = implode(', ', $info['labels']) ?: ($info['order'] ? 'No active purchaser membership' : 'No order link');
        $transitions[$key] = ($transitions[$key] ?? 0) + 1;
    }
}
echo json_encode(['totals' => $totals, 'generic_membership_purchaser_types' => $transitions], JSON_PRETTY_PRINT) . PHP_EOL;
