import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PostAdoptionPage } from './post-adoption.page';

describe('PostAdoptionPage', () => {
  let component: PostAdoptionPage;
  let fixture: ComponentFixture<PostAdoptionPage>;

  beforeEach(() => {
    fixture = TestBed.createComponent(PostAdoptionPage);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
