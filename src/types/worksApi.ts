export type WorksResponse = { items: WorkItem[]; has_more?: boolean };

export type WorkTag = {
  id?: number | null;
  code?: string | number | null;
  name?: string | null;
};

export type WorkProduct = {
  name?: string | null;
  units?: string | number | null;
  teeth?: string | null;
  product?: {
    id?: number | null;
    code?: string | number | null;
    name?: string | null;
  } | null;
  price?: string | number | null;
  discount?: string | number | null;
  unit_price?: string | number | null;
  total_price?: string | number | null;
  vat?: string | number | null;
};

export type WorkTask = {
  id?: number | null;
  stage?: {
    id?: number | null;
    name?: string | null;
  } | null;
  manufacturer?: {
    type?: string | null;
    id?: number | null;
    name?: string | null;
  } | null;
  status?: string | null;
  status_name?: string | null;
  start_date?: string | null;
  finish_date?: string | null;
  estimated_delivery?: string | null;
  teeth_count?: number | null;
  cost?: string | number | null;
  commission?: string | number | null;
  work_time?: string | number | null;
};

export type WorkItem = {
  id: number;
  code?: string | null;
  box?: string | null;
  created_at?: string | null;
  order_date?: string | null;
  accept_date?: string | null;
  estimated_delivery?: string | null;
  deadline?: string | null;
  finish_date?: string | null;
  delivery_note_date?: string | null;
  status?: string | null;
  status_name?: string | null;
  observations?: string | null;
  internal_notes?: string | null;
  total_price?: string | number | null;
  total_price_with_vat?: string | number | null;

  clinic_id?: number | null;
  doctor_id?: number | null;

  clinic?: {
    id?: number | null;
    code?: string | number | null;
    name?: string | null;
  } | null;
  doctor?: {
    id?: number | null;
    name?: string | null;
  } | null;

  patient_name?: string | null;
  patient?: {
    name?: string | null;
    age?: string | null;
    sex?: string | null;
    sex_name?: string | null;
  } | null;

  tags?: WorkTag[] | null;
  products?: WorkProduct[] | null;
  lots?: any[] | null;
  tasks?: WorkTask[] | null;
};
