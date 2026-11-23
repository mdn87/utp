export interface ReviewNotification {
  schema: "utp-review-delivery/v1";
  type: "review.ready" | "review.resolved";
  event_id: string;
  dedupe_key: string;
  review_id: string;
  questions: number;
}

export interface ReportInboxItem {
  schema: "utp-report-notice/v1";
  created: string;
  title: string;
  body_md: string;
  review_id: string;
}

export interface DeliveryAdapter {
  sendReview?: (event: ReviewNotification, signal: AbortSignal) => Promise<{ ok?: boolean; event_id?: string }>;
  formatInboxItem?: (item: ReportInboxItem) => object;
}
