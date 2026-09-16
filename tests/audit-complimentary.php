<?php
// Read-only aggregate audit. No emails, names or secrets are printed.
$eventId = 99001;
global $wpdb;
$ids = $wpdb->get_col($wpdb->prepare("SELECT DISTINCT booking_id FROM {$wpdb->prefix}mec_bookings WHERE event_id = %d AND confirmed = 1", $eventId));
$groups = [];
foreach ($ids as $bid) {
    $order = wc_get_order((int) get_post_meta($bid, 'mec_order_id', true));
    if (!$order) continue;
    $comp = 0; $snapshots = [];
    foreach ($order->get_items() as $item) {
        $breakdown = json_decode((string) $item->get_meta('_seating_studio_final_breakdown', true), true);
        if (!is_array($breakdown) || (int) ($breakdown['event_id'] ?? 0) !== $eventId) continue;
        $comp += (int) ($breakdown['complimentary_qty'] ?? 0);
        $snapshots[] = ['category' => $breakdown['category'] ?? '', 'qty' => $breakdown['quantity'] ?? 0, 'comp' => $breakdown['complimentary_qty'] ?? 0, 'customer_match' => (int) ($breakdown['user_id'] ?? 0) === $order->get_customer_id(), 'item_total' => $item->get_total()];
    }
    $key = json_encode(['order_status' => $order->get_status(), 'is_paid' => $order->is_paid(), 'has_paid_date' => (bool) $order->get_date_paid(), 'zero_total' => (float) $order->get_total() === 0.0, 'mec_payable_positive' => (float) get_post_meta($bid, 'mec_payable', true) > 0, 'saved_comp' => (int) get_post_meta($bid, 'seating_studio_complimentary_qty', true), 'snapshot_comp' => $comp, 'snapshot_categories' => array_column($snapshots, 'category')]);
    $groups[$key] = ($groups[$key] ?? 0) + 1;
}
echo json_encode($groups, JSON_PRETTY_PRINT) . PHP_EOL;
