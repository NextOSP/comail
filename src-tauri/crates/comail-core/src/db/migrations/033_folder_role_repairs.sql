-- Rust normalization records demoted roles before clearing heuristic evidence.
CREATE TABLE folder_role_repairs (
    folder_id INTEGER PRIMARY KEY REFERENCES folders(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
);
