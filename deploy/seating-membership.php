<?php
/**
 * Plugin Name: Seating Booking Membership
 * Description: Exposes purchaser membership and verified order eligibility on authenticated MEC Utility exports only.
 */
defined('ABSPATH') || exit;

function seating_studio_order_payment($order) {
    $result = ['eligible' => false, 'kind' => 'unverified'];
    if (!$order) return $result;
    $status = $order->get_status();
    $total = (float) $order->get_total();
    // A paid date alone is insufficient: cancelled, refunded and on-hold orders stay excluded.
    $settled = in_array($status, ['processing', 'completed'], true) && $order->is_paid();
    // N-Genius uses its own completed status instead of WooCommerce's standard status.
    $settled = $settled || ($status === 'ng-complete' && (bool) $order->get_date_paid());
    if (!$settled || (float) $order->get_total_refunded() > 0 || $total < 0) return $result;
    if ($total == 0.0 && $status !== 'completed') return $result;
    return ['eligible' => true, 'kind' => $total == 0.0 ? 'complimentary' : 'paid'];
}

add_filter('rest_post_dispatch', function ($response, $server, $request) {
    if (!preg_match('#^/mec-utility/v1/events/(\d+)/attendees/flat/?$#', $request->get_route(), $match)
        || $request->get_param('include_membership') !== '1'
        || !($response instanceof WP_REST_Response) || $response->get_status() !== 200) return $response;
    $data = $response->get_data();
    if (!isset($data['attendees']) || !is_array($data['attendees'])) return $response;
    $orders = [];
    $memberships = [];
    foreach ($data['attendees'] as &$attendee) {
        $bid = (int) ($attendee['booking_id'] ?? 0);
        $membership = ['status' => 'unavailable', 'levels' => [], 'checkedAt' => gmdate('c'), 'source' => 'woocommerce-purchaser'];
        $payment = ['eligible' => false, 'kind' => 'unverified'];
        try {
            // Never substitute MEC's user_id/post_author: these can represent the first attendee.
            if ((int) get_post_meta($bid, 'mec_event_id', true) !== (int) $match[1]) throw new RuntimeException('Event mismatch');
            $oid = (int) get_post_meta($bid, 'mec_order_id', true);
            if (!array_key_exists($oid, $orders)) $orders[$oid] = $oid && function_exists('wc_get_order') ? wc_get_order($oid) : null;
            $order = $orders[$oid];
            $payment = seating_studio_order_payment($order);
            if ($order) {
                $uid = (int) $order->get_customer_id();
                if (!isset($memberships[$uid])) {
                    if (!$uid || !get_userdata($uid)) {
                        $membership['status'] = 'no-account';
                    } elseif (is_callable(['Ihc_Db', 'get_user_levels'])) {
                        foreach ((array) Ihc_Db::get_user_levels($uid, false) as $level) {
                            $label = sanitize_text_field($level['label'] ?? '');
                            if ($label !== '') $membership['levels'][] = ['name' => $label, 'active' => isset($level['is_expired']) && $level['is_expired'] === false];
                        }
                        $active = array_filter($membership['levels'], function ($level) { return $level['active']; });
                        $membership['status'] = $active ? 'active' : ($membership['levels'] ? 'inactive' : 'none');
                    }
                    $memberships[$uid] = $membership;
                }
                $membership = $memberships[$uid];
            }
        } catch (Throwable $error) {
            $membership['status'] = 'unavailable';
            $membership['levels'] = [];
            $payment = ['eligible' => false, 'kind' => 'unverified'];
        }
        $attendee['booking_membership'] = $membership;
        $attendee['booking_payment'] = $payment;
    }
    unset($attendee);
    $response->set_data($data);
    $response->header('Cache-Control', 'private, no-store');
    return $response;
}, 10, 3);
