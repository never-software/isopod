puts "Seeding posts..."

Post.create!([
  { title: "Welcome to isopod", body: "Each pod is an isolated workspace for a feature.", published: true },
  { title: "Getting started", body: "Run `isopod create my-feature example-api example-frontend` to create your first pod.", published: true },
  { title: "Draft post", body: "This post is still a work in progress.", published: false }
])

puts "Created #{Post.count} posts"
