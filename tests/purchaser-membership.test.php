<?php
// Standalone PHP regression test: no WordPress bootstrap or database writes.
define('ABSPATH', __DIR__);
function add_filter($name, $callback, $priority, $argc) { $GLOBALS['hook'] = $callback; }
function get_post_meta($bid, $key, $single) { return $key === 'mec_event_id' ? ($bid === 99 ? 2 : 99001) : ($bid === 3 ? 0 : $bid); }
function get_userdata($uid) { return $uid > 0; }
function sanitize_text_field($value) { return strip_tags($value); }
class Ihc_Db { static function get_user_levels($uid, $expire) { return [['label' => $uid === 10 ? 'Premium Corporate Member' : 'Corporate Member', 'is_expired' => false]]; } }
class Order {
  function __construct(public $uid, public $status = 'completed', public $total = 0, public $refunded = 0, public $paidDate = true) {}
  function get_customer_id() { return $this->uid; }
  function get_status() { return $this->status; }
  function get_total() { return $this->total; }
  function get_total_refunded() { return $this->refunded; }
  function is_paid() { return in_array($this->status, ['processing','completed'], true); }
  function get_date_paid() { return $this->paidDate; }
}
function wc_get_order($oid) { return new Order($oid === 1 ? 10 : 20); }
class WP_REST_Response {
  function __construct(public $data, public $status = 200) {}
  function get_data() { return $this->data; }
  function set_data($d) { $this->data = $d; }
  function get_status() { return $this->status; }
  function header($a,$b) {}
}
class Request {
  function __construct(public $include = '1') {}
  function get_route() { return '/mec-utility/v1/events/99001/attendees/flat'; }
  function get_param($key) { return $this->include; }
}
function check($condition, $message) { if (!$condition) throw new RuntimeException($message); }
require $argv[1];
$response = new WP_REST_Response(['attendees' => [['booking_id'=>1,'email'=>'child@example.test'],['booking_id'=>1,'email'=>'another@example.test'],['booking_id'=>2],['booking_id'=>3],['booking_id'=>99]]]);
$result = ($GLOBALS['hook'])($response, null, new Request());
$a = $result->data['attendees'];
check($a[0]['booking_membership']['levels'][0]['name'] === 'Premium Corporate Member', 'Purchaser membership mismatch');
check($a[0]['booking_membership'] === $a[1]['booking_membership'], 'Attendee email must not affect membership');
check($a[2]['booking_membership']['levels'][0]['name'] === 'Corporate Member', 'Wrong order account');
check($a[3]['booking_membership']['status'] === 'unavailable' && !$a[3]['booking_payment']['eligible'], 'Missing order must not fall back to attendee');
check(!$a[4]['booking_payment']['eligible'], 'Event mismatch should fail closed');
foreach (['pending','on-hold','failed','cancelled','refunded'] as $status) check(!seating_studio_order_payment(new Order(10,$status,500))['eligible'], 'Unpaid or cancelled order admitted');
check(!seating_studio_order_payment(new Order(10,'completed',500,100))['eligible'], 'Refund must require review');
check(seating_studio_order_payment(new Order(10,'ng-complete',500))['kind'] === 'paid', 'N-Genius completed payment rejected');
check(!seating_studio_order_payment(new Order(10,'ng-complete',500,0,false))['eligible'], 'Unverified N-Genius admitted');
check(seating_studio_order_payment(new Order(10))['kind'] === 'complimentary', 'Completed zero order rejected');
check(!seating_studio_order_payment(new Order(10,'processing',0))['eligible'], 'Incomplete zero order admitted');
$denied = new WP_REST_Response(['error'=>'Unauthorized'],401);
check(($GLOBALS['hook'])($denied,null,new Request()) === $denied, 'Denied response changed');
echo "PASS: purchaser resolution, multiple attendees, missing order, event isolation, complimentary, payment, refunds and auth guards\n";
